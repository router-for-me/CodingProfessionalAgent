import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { MemoryCitationsView } from './MemoryCitationsView.js'

describe('MemoryCitationsView', () => {
    it('renders nothing when citations or entries are empty', () => {
        const { container, rerender } = render(<MemoryCitationsView />)
        expect(container.firstChild).toBeNull()

        rerender(<MemoryCitationsView citations={{ entries: [] }} />)
        expect(container.firstChild).toBeNull()
    })

    it('renders citation toggle button with count and expands on click', () => {
        const citations = {
            entries: [
                {
                    file: 'extensions/ad_hoc/notes/triage-5847.md',
                    lineRange: '1-8',
                    note: 'prior triage workflow and decision criteria',
                },
                {
                    file: 'extensions/ad_hoc/notes/triage-5851.md',
                    lineRange: '1-10',
                    note: 'outcome B handling conventions',
                },
            ],
            rolloutIds: ['019c6e27-e55b-73d1-87d8-4e01f1f75043'],
        }

        render(<MemoryCitationsView citations={citations} />)

        const toggle = screen.getByTestId('memory-citations-toggle')
        expect(toggle).toBeInTheDocument()
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByText(/2.*(记忆引用|memory citations)/i)).toBeInTheDocument()

        // List should not be visible before clicking
        expect(screen.queryByTestId('memory-citations-list')).not.toBeInTheDocument()

        // Click to expand
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByTestId('memory-citations-list')).toBeInTheDocument()

        // Verify entries rendered
        expect(screen.getByText('extensions/ad_hoc/notes/triage-5847.md')).toBeInTheDocument()
        expect(screen.getByText('prior triage workflow and decision criteria')).toBeInTheDocument()
        expect(screen.getByText('extensions/ad_hoc/notes/triage-5851.md')).toBeInTheDocument()
        expect(screen.getByText('outcome B handling conventions')).toBeInTheDocument()
        expect(screen.getByText('019c6e27-e55b-73d1-87d8-4e01f1f75043')).toBeInTheDocument()

        // Click again to collapse
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByTestId('memory-citations-list')).not.toBeInTheDocument()
    })
})
