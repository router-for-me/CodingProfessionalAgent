import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { readSkillDraftParts, SkillDraftEditor } from './SkillDraftEditor.js'
import { skillReferencesFromParts } from './skillDraft.js'

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

    it('scrolls to the end position when content height exceeds maxHeight on multiline input', () => {
        const handleChange = vi.fn()
        render(
            <SkillDraftEditor
                value={'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9'}
                maxHeight={100}
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        // Mock scroll dimensions where scrollHeight exceeds clientHeight
        Object.defineProperty(input, 'scrollHeight', { value: 300, configurable: true })
        Object.defineProperty(input, 'clientHeight', { value: 100, configurable: true })

        // Trigger input event
        fireEvent.input(input)

        // Verifies scrollTop was adjusted to show the end position
        expect(input.scrollTop).toBe(300)
    })

    it('does not select a menu item or submit while IME composition is active', () => {
        const onKeyDown = vi.fn()
        render(<SkillDraftEditor value="#demo" trigger="#" skills={[{ name: 'demo' }]}
            onChange={vi.fn()} onKeyDown={onKeyDown} />)
        const input = screen.getByTestId('composer-input')
        fireEvent.compositionStart(input)
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onKeyDown).not.toHaveBeenCalled()
        fireEvent.compositionEnd(input)
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onKeyDown).toHaveBeenCalledOnce()
    })

    it('preserves literal text while copying only actual chips with the chosen symbol', () => {
        const inputValue = '$demo $demo'
        render(<SkillDraftEditor value={inputValue} trigger="#" references={[{ start: 6, name: 'demo' }]}
            skills={[{ name: 'demo' }]} onChange={vi.fn()} />)
        const input = screen.getByTestId('composer-input')
        const selection = window.getSelection()!
        const range = document.createRange()
        range.selectNodeContents(input)
        selection.removeAllRanges()
        selection.addRange(range)
        const clipboard = { setData: vi.fn(), getData: vi.fn() }
        fireEvent.copy(input, { clipboardData: clipboard })
        expect(clipboard.setData).toHaveBeenCalledWith('text/plain', '$demo #demo')
    })

    it('does not turn a restored raw legacy slash draft into a chip in another mode', () => {
        render(<SkillDraftEditor value="/skill:demo" trigger="#" skills={[{ name: 'demo' }]} onChange={vi.fn()} />)
        expect(screen.queryByTestId('composer-skill-chip')).toBeNull()
        expect(screen.getByTestId('composer-input')).toHaveTextContent('/skill:demo')
    })

    it.each(['#', '/'] as const)('keeps unmarked /skill:name literal and round-trips marked %s chips', (trigger) => {
        const onChange = vi.fn()
        const { rerender } = render(<SkillDraftEditor value="/skill:demo $demo" trigger={trigger}
            references={[{ start: 12, name: 'demo' }]} skills={[{ name: 'demo' }]} onChange={onChange} />)
        const input = screen.getByTestId('composer-input')
        const selection = window.getSelection()!
        const range = document.createRange()
        range.selectNodeContents(input)
        selection.removeAllRanges()
        selection.addRange(range)
        const data = new Map<string, string>()
        const clipboardData = { getData: (format: string) => data.get(format) ?? '', setData: (format: string, value: string) => data.set(format, value) }
        fireEvent.copy(input, { clipboardData })
        expect(data.get('text/plain')).toBe(`/skill:demo ${trigger === '/' ? '/skill:' : '#'}demo`)
        rerender(<SkillDraftEditor value="" trigger={trigger} skills={[{ name: 'demo' }]} onChange={onChange} />)
        fireEvent.paste(input, { clipboardData })
        expect(onChange).toHaveBeenLastCalledWith('/skill:demo $demo', expect.any(Number))
        expect(skillReferencesFromParts(readSkillDraftParts(input))).toEqual([{ start: 12, name: 'demo' }])
        data.clear()
        data.set('text/plain', '/skill:demo')
        rerender(<SkillDraftEditor value=" " trigger={trigger} skills={[{ name: 'demo' }]} onChange={onChange} />)
        rerender(<SkillDraftEditor value="" trigger={trigger} skills={[{ name: 'demo' }]} onChange={onChange} />)
        fireEvent.paste(input, { clipboardData })
        expect(readSkillDraftParts(input)).toEqual([{ type: 'text', text: '/skill:demo' }])
    })

    it('preserves a literal selected-trigger token beside a marked card on paste', () => {
        const onChange = vi.fn()
        const { rerender } = render(<SkillDraftEditor value="#demo $demo" trigger="#"
            references={[{ start: 6, name: 'demo' }]} skills={[{ name: 'demo' }]} onChange={onChange} />)
        const input = screen.getByTestId('composer-input')
        const range = document.createRange()
        range.selectNodeContents(input)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        const data = new Map<string, string>()
        const clipboardData = { getData: (format: string) => data.get(format) ?? '', setData: (format: string, value: string) => data.set(format, value) }
        fireEvent.copy(input, { clipboardData })
        rerender(<SkillDraftEditor value="" trigger="#" skills={[{ name: 'demo' }]} onChange={onChange} />)
        fireEvent.paste(input, { clipboardData })
        expect(readSkillDraftParts(input)).toEqual([
            { type: 'text', text: '#demo ' },
            { type: 'skill', name: 'demo', displayName: 'Demo' },
        ])
        expect(onChange).toHaveBeenLastCalledWith('#demo $demo', expect.any(Number))
    })

    it('cuts and pastes an actual / skill card without accepting the same unmarked plain text', () => {
        const onChange = vi.fn()
        render(<SkillDraftEditor value="$demo" trigger="/" references={[{ start: 0, name: 'demo' }]}
            skills={[{ name: 'demo' }]} onChange={onChange} />)
        const input = screen.getByTestId('composer-input')
        const selection = window.getSelection()!
        const range = document.createRange()
        range.selectNodeContents(input)
        selection.removeAllRanges()
        selection.addRange(range)
        const data = new Map<string, string>()
        const clipboardData = { getData: (format: string) => data.get(format) ?? '', setData: (format: string, value: string) => data.set(format, value) }
        fireEvent.cut(input, { clipboardData })
        expect(data.get('text/plain')).toBe('/skill:demo')
        expect(data.get('application/x-cpa-skill-draft+json')).toBeTruthy()
        expect(input.querySelector('[data-skill-name]')).toBeNull()
        fireEvent.paste(input, { clipboardData })
        expect(input.querySelector('[data-skill-name]')).toHaveAttribute('data-skill-name', 'demo')
        expect(onChange).toHaveBeenLastCalledWith('$demo', expect.any(Number))
    })

    it('does not turn a direct /model command into a chip when cutting its trailing argument', () => {
        const onChange = vi.fn()
        render(<SkillDraftEditor value="/model abc" trigger="/" reservedSlashNames={['model']}
            skills={[{ name: 'model' }]} onChange={onChange} />)
        const input = screen.getByTestId('composer-input')
        const range = document.createRange()
        range.setStart(input.firstChild!, 7)
        range.setEnd(input.firstChild!, 10)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        fireEvent.cut(input, { clipboardData: { setData: vi.fn() } })
        expect(input.querySelector('[data-skill-name]')).toBeNull()
        expect(onChange).toHaveBeenLastCalledWith('/model ', 7)
        expect(readSkillDraftParts(input)).toEqual([{ type: 'text', text: '/model ' }])
    })

    it.each([
        [' /model hi', 'model', 8],
        ['\n/compact focus', 'compact', 9],
    ])('keeps a whitespace-prefixed slash control as text through paste and cut: %s', (text, name, argumentStart) => {
        const onChange = vi.fn()
        render(<SkillDraftEditor value="" trigger="/" reservedSlashNames={['model', 'compact']}
            skills={[{ name: 'model' }, { name: 'compact' }]} onChange={onChange} />)
        const input = screen.getByTestId('composer-input')
        fireEvent.paste(input, { clipboardData: { getData: () => text } })
        expect(readSkillDraftParts(input)).toEqual([{ type: 'text', text }])
        const range = document.createRange()
        range.setStart(input.firstChild!, argumentStart)
        range.setEnd(input.firstChild!, text.length)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        fireEvent.cut(input, { clipboardData: { setData: vi.fn() } })
        expect(readSkillDraftParts(input)).toEqual([{ type: 'text', text: text.slice(0, argumentStart) }])
        expect(onChange).toHaveBeenLastCalledWith(text.slice(0, argumentStart), argumentStart)
    })

    it('keeps a slash control after a separate leading newline node during typing and cut', () => {
        const onChange = vi.fn()
        render(<SkillDraftEditor value="" trigger="/" reservedSlashNames={['compact']}
            skills={[{ name: 'compact' }]} onChange={onChange} />)
        const input = screen.getByTestId('composer-input')
        const line = document.createTextNode('/compact focus')
        input.replaceChildren(document.createElement('br'), line)
        const selection = window.getSelection()!
        const range = document.createRange()
        range.setStart(line, line.length)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        fireEvent.input(input)
        expect(input.querySelector('[data-skill-name]')).toBeNull()
        expect(onChange).toHaveBeenLastCalledWith('\n/compact focus', expect.any(Number))
        range.setStart(line, 9)
        range.setEnd(line, line.length)
        selection.removeAllRanges()
        selection.addRange(range)
        fireEvent.cut(input, { clipboardData: { setData: vi.fn() } })
        expect(input.querySelector('[data-skill-name]')).toBeNull()
        expect(onChange).toHaveBeenLastCalledWith('\n/compact ', 10)
    })

    it('pastes only selected-trigger plain text as chips', () => {
        const onChange = vi.fn()
        render(<SkillDraftEditor value="" trigger="#" skills={[{ name: 'demo' }]} onChange={onChange} />)
        const input = screen.getByTestId('composer-input')
        fireEvent.paste(input, { clipboardData: { getData: () => '$demo /skill:demo #demo' } })
        expect(onChange).toHaveBeenCalledWith('$demo /skill:demo $demo', expect.any(Number))
        expect(input.querySelectorAll('[data-skill-name]')).toHaveLength(1)
    })

    it('prevents default and does not produce a newline when Backspace is pressed on empty editor', () => {
        const handleChange = vi.fn()
        render(
            <SkillDraftEditor
                value=""
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        const backspaceEvent = new KeyboardEvent('keydown', {
            key: 'Backspace',
            code: 'Backspace',
            bubbles: true,
            cancelable: true,
        })
        input.dispatchEvent(backspaceEvent)

        expect(backspaceEvent.defaultPrevented).toBe(true)
        expect(handleChange).not.toHaveBeenCalled()
    })

    it('prevents default when Delete is pressed on empty editor', () => {
        const handleChange = vi.fn()
        render(
            <SkillDraftEditor
                value=""
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')
        const deleteEvent = new KeyboardEvent('keydown', {
            key: 'Delete',
            code: 'Delete',
            bubbles: true,
            cancelable: true,
        })
        input.dispatchEvent(deleteEvent)

        expect(deleteEvent.defaultPrevented).toBe(true)
        expect(handleChange).not.toHaveBeenCalled()
    })

    it('does not produce a newline when editor content is cleared and browser inserts a filler br', () => {
        const handleChange = vi.fn()
        render(
            <SkillDraftEditor
                value=""
                onChange={handleChange}
            />,
        )

        const input = screen.getByTestId('composer-input')

        // Simulate browser inserting a filler <br> on empty contenteditable element
        input.innerHTML = '<br>'
        fireEvent.input(input)

        // Must emit empty string with cursor 0, not a newline '\n'
        expect(handleChange).toHaveBeenCalledWith('', 0)
        // Must normalize DOM back to clean zero-width space without residual <br>
        expect(input.querySelector('br')).toBeNull()
        expect(input.textContent).toBe('\u200b')
    })
})
