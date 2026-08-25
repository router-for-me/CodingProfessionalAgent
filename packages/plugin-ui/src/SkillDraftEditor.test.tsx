import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SkillDraftEditor } from './SkillDraftEditor.js'

describe('SkillDraftEditor', () => {
    it('shows placeholder pseudo-class when value is empty and not composing', () => {
        render(
            <SkillDraftEditor
                value=""
                placeholder="Type a message..."
                onChange={vi.fn()}
            />,
        )

        const input = screen.getByTestId('composer-input')
        expect(input.className).toContain('before:content-[attr(data-placeholder)]')
        expect(input).toHaveAttribute('data-placeholder', 'Type a message...')
    })

    it('hides placeholder when value is non-empty', () => {
        render(
            <SkillDraftEditor
                value="Hello world"
                placeholder="Type a message..."
                onChange={vi.fn()}
            />,
        )

        const input = screen.getByTestId('composer-input')
        expect(input.className).not.toContain('before:content-[attr(data-placeholder)]')
    })

    it('hides placeholder during IME composition even when value is still empty', () => {
        const handleChange = vi.fn()
        render(
            <SkillDraftEditor
                value=""
                placeholder="Type a message..."
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        expect(input.className).toContain('before:content-[attr(data-placeholder)]')

        // Start IME composition (e.g. typing Chinese pinyin)
        fireEvent.compositionStart(input)

        // While composing, placeholder must not be displayed so it does not overlap composition text
        expect(input.className).not.toContain('before:content-[attr(data-placeholder)]')

        // End IME composition without value change (simulating cancelled composition)
        fireEvent.compositionEnd(input)

        // After cancelled composition, placeholder reappears
        expect(input.className).toContain('before:content-[attr(data-placeholder)]')
    })

    it('expands height when text wraps during IME composition before composition completes', () => {
        const handleChange = vi.fn()
        render(
            <SkillDraftEditor
                value=""
                placeholder="Type a message..."
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')

        let currentScrollHeight = 22
        Object.defineProperty(input, 'scrollHeight', {
            configurable: true,
            get: () => currentScrollHeight,
        })

        // Initial single-line height
        expect(input.style.height).toBe('22px')

        // Start IME composition (e.g. typing Chinese characters)
        fireEvent.compositionStart(input)

        // Simulate wrapping to second line while still composing
        currentScrollHeight = 44
        fireEvent.input(input)

        // The editor height must expand to 44px even during IME composition
        expect(input.style.height).toBe('44px')
        // onChange must not be emitted during composition
        expect(handleChange).not.toHaveBeenCalled()

        // Simulate continuing composition on update
        currentScrollHeight = 66
        fireEvent.compositionUpdate(input)
        expect(input.style.height).toBe('66px')

        // End composition
        currentScrollHeight = 44
        fireEvent.compositionEnd(input)
        expect(input.style.height).toBe('44px')
    })

    it('caps height at maxHeight and enables scroll when content overflows', () => {
        render(
            <SkillDraftEditor
                value=""
                maxHeight={160}
                onChange={vi.fn()}
            />,
        )

        const input = screen.getByTestId('composer-input')

        let currentScrollHeight = 22
        Object.defineProperty(input, 'scrollHeight', {
            configurable: true,
            get: () => currentScrollHeight,
        })

        fireEvent.compositionStart(input)

        // Simulate large wrapped composition exceeding 160px
        currentScrollHeight = 220
        fireEvent.input(input)

        expect(input.style.height).toBe('160px')
        expect(input.style.overflowY).toBe('auto')
    })

    it('pastes plain text, allows undo with Cmd+Z and redo with Cmd+Shift+Z', () => {
        const handleChange = vi.fn()
        const { rerender } = render(
            <SkillDraftEditor
                value=""
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        input.focus()

        const clipboardData = {
            getData: (format: string) => (format === 'text/plain' ? 'pasted text\r\nline2' : ''),
        }

        fireEvent.paste(input, { clipboardData })
        expect(handleChange).toHaveBeenCalledWith('pasted text\nline2', 'pasted text\nline2'.length)

        rerender(
            <SkillDraftEditor
                value={'pasted text\nline2'}
                onChange={handleChange}
            />,
        )

        // Trigger undo with Meta+Z
        fireEvent.keyDown(input, { key: 'z', metaKey: true })
        expect(handleChange).toHaveBeenLastCalledWith('', 0)

        rerender(
            <SkillDraftEditor
                value=""
                onChange={handleChange}
            />,
        )

        // Trigger redo with Meta+Shift+Z
        fireEvent.keyDown(input, { key: 'z', metaKey: true, shiftKey: true })
        expect(handleChange).toHaveBeenLastCalledWith('pasted text\nline2', 'pasted text\nline2'.length)
    })

    it('pastes text containing skill draft chip and correctly undoes with Cmd+Z without duplicating text', () => {
        const handleChange = vi.fn()
        const skills = [{ name: 'gh-issue' }]

        const { rerender } = render(
            <SkillDraftEditor
                value=""
                skills={skills}
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        input.focus()

        // Paste text containing a skill chip pattern
        const clipboardData = {
            getData: (format: string) => (format === 'text/plain' ? '$gh-issue 1223' : ''),
        }

        fireEvent.paste(input, { clipboardData })

        // Value must be emitted and chip element must be in DOM
        expect(handleChange).toHaveBeenCalledWith('$gh-issue 1223', '$gh-issue 1223'.length)
        expect(screen.getByTestId('composer-skill-chip')).toHaveAttribute('data-skill-name', 'gh-issue')

        rerender(
            <SkillDraftEditor
                value="$gh-issue 1223"
                skills={skills}
                onChange={handleChange}
            />,
        )

        // Press Cmd+Z to undo
        fireEvent.keyDown(input, { key: 'z', metaKey: true })

        // Undo must cleanly revert to empty state without duplicating or appending extra text
        expect(handleChange).toHaveBeenLastCalledWith('', 0)
        expect(screen.queryByTestId('composer-skill-chip')).not.toBeInTheDocument()

        rerender(
            <SkillDraftEditor
                value=""
                skills={skills}
                onChange={handleChange}
            />,
        )

        // Press Cmd+Shift+Z to redo
        fireEvent.keyDown(input, { key: 'z', metaKey: true, shiftKey: true })
        expect(handleChange).toHaveBeenLastCalledWith('$gh-issue 1223', '$gh-issue 1223'.length)
        expect(screen.getByTestId('composer-skill-chip')).toHaveAttribute('data-skill-name', 'gh-issue')
    })

    it('handles beforeinput historyUndo and historyRedo events from browser edit menu', () => {
        const handleChange = vi.fn()
        const { rerender } = render(
            <SkillDraftEditor
                value=""
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        input.focus()

        fireEvent.paste(input, {
            clipboardData: {
                getData: (f: string) => (f === 'text/plain' ? 'some content' : ''),
            },
        })
        expect(handleChange).toHaveBeenCalledWith('some content', 'some content'.length)

        rerender(
            <SkillDraftEditor
                value="some content"
                onChange={handleChange}
            />,
        )

        // Simulate browser menu Edit -> Undo
        const undoEvent = new Event('beforeinput', { bubbles: true, cancelable: true })
        Object.defineProperty(undoEvent, 'inputType', { value: 'historyUndo' })
        fireEvent(input, undoEvent)
        expect(handleChange).toHaveBeenLastCalledWith('', 0)

        rerender(
            <SkillDraftEditor
                value=""
                onChange={handleChange}
            />,
        )

        // Simulate browser menu Edit -> Redo
        const redoEvent = new Event('beforeinput', { bubbles: true, cancelable: true })
        Object.defineProperty(redoEvent, 'inputType', { value: 'historyRedo' })
        fireEvent(input, redoEvent)
        expect(handleChange).toHaveBeenLastCalledWith('some content', 'some content'.length)
    })

    it('undoes Backspace chip deletion properly', () => {
        const handleChange = vi.fn()
        const skills = [{ name: 'gh-issue' }]

        const { rerender } = render(
            <SkillDraftEditor
                value="$gh-issue"
                skills={skills}
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        expect(screen.getByTestId('composer-skill-chip')).toBeInTheDocument()

        // Press Backspace when only chip is present
        fireEvent.keyDown(input, { key: 'Backspace' })
        expect(handleChange).toHaveBeenCalledWith('', 0)

        rerender(
            <SkillDraftEditor
                value=""
                skills={skills}
                onChange={handleChange}
            />,
        )

        // Press Cmd+Z to restore deleted chip
        fireEvent.keyDown(input, { key: 'z', metaKey: true })
        expect(handleChange).toHaveBeenLastCalledWith('$gh-issue', '$gh-issue'.length)
        expect(screen.getByTestId('composer-skill-chip')).toBeInTheDocument()
    })

    it('does not preventDefault on native navigation shortcuts like Cmd+Left and Cmd+Right', () => {
        const handleKeyDown = vi.fn()
        render(
            <SkillDraftEditor
                value="Reply and close issue: whether in"
                onChange={vi.fn()}
                onKeyDown={handleKeyDown}
            />,
        )

        const input = screen.getByTestId('composer-input')

        const cmdLeftEvent = new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            code: 'ArrowLeft',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        input.dispatchEvent(cmdLeftEvent)

        expect(cmdLeftEvent.defaultPrevented).toBe(false)
        expect(handleKeyDown).toHaveBeenCalledTimes(1)

        const cmdRightEvent = new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            code: 'ArrowRight',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        input.dispatchEvent(cmdRightEvent)

        expect(cmdRightEvent.defaultPrevented).toBe(false)
        expect(handleKeyDown).toHaveBeenCalledTimes(2)
    })

    it('focuses the editor when autoFocus is true', () => {
        render(
            <SkillDraftEditor
                value=""
                onChange={vi.fn()}
                autoFocus
            />,
        )

        const input = screen.getByTestId('composer-input')
        expect(document.activeElement).toBe(input)
    })

    it('inserts a newline on Enter key when not prevented by external onKeyDown', () => {
        const handleChange = vi.fn()
        render(
            <SkillDraftEditor
                value="hello"
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(handleChange).toHaveBeenCalledWith('hello\n', 6)
    })

    it('does not insert a newline on Enter key when external onKeyDown prevents default', () => {
        const handleChange = vi.fn()
        const handleKeyDown = vi.fn((e: React.KeyboardEvent) => {
            e.preventDefault()
        })
        render(
            <SkillDraftEditor
                value="hello"
                onChange={handleChange}
                onKeyDown={handleKeyDown}
            />,
        )

        const input = screen.getByTestId('composer-input')
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(handleKeyDown).toHaveBeenCalledTimes(1)
        expect(handleChange).not.toHaveBeenCalled()
    })

    it('renders trailing zero-width space on text ending with newline so browser creates a line box', () => {
        render(
            <SkillDraftEditor
                value={'hello\n'}
                onChange={vi.fn()}
            />,
        )

        const input = screen.getByTestId('composer-input')
        // Must contain trailing ZWSP \u200b after newline to avoid browser collapsing the trailing newline
        expect(input.textContent).toBe('hello\n\u200b')
    })

    it('allows typing a newline with a single Enter press', () => {
        let currentValue = 'Line 1'
        const handleChange = vi.fn((next: string) => {
            currentValue = next
        })
        const { rerender } = render(
            <SkillDraftEditor
                value={currentValue}
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        // First Enter press must immediately produce a newline
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(handleChange).toHaveBeenCalledTimes(1)
        expect(handleChange).toHaveBeenCalledWith('Line 1\n', 7)

        // Rerender with updated value
        rerender(
            <SkillDraftEditor
                value={currentValue}
                onChange={handleChange}
            />,
        )

        // Second line must have trailing ZWSP so caret is displayed on line 2
        expect(input.textContent).toBe('Line 1\n\u200b')
    })
})
