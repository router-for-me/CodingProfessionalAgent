import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { GitDiffFile } from '../utils/gitDiff.js'
import { SingleFileNavHeader } from './SingleFileNavHeader.js'

describe('SingleFileNavHeader', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

    const mockFile: GitDiffFile = {
        oldPath: 'src/components/App.tsx',
        newPath: 'src/components/App.tsx',
        displayPath: 'src/components/App.tsx',
        status: 'modified',
        additions: 15,
        deletions: 3,
        isBinary: false,
        hunks: [],
    }

    it('renders current file info, counter, and navigation buttons', () => {
        const onPrev = vi.fn()
        const onNext = vi.fn()

        render(
            <SingleFileNavHeader
                file={mockFile}
                currentIndex={1}
                totalFiles={5}
                isLargeDiff={false}
                onPrevFile={onPrev}
                onNextFile={onNext}
            />,
        )

        expect(screen.getByTestId('single-file-nav-header')).toBeInTheDocument()
        expect(screen.getByText('src/components/App.tsx')).toBeInTheDocument()
        expect(screen.getByTestId('single-file-counter')).toHaveTextContent('File 2 of 5')

        const prevBtn = screen.getByTestId('single-file-prev-button')
        const nextBtn = screen.getByTestId('single-file-next-button')

        expect(prevBtn).not.toBeDisabled()
        expect(nextBtn).not.toBeDisabled()

        fireEvent.click(prevBtn)
        expect(onPrev).toHaveBeenCalledTimes(1)

        fireEvent.click(nextBtn)
        expect(onNext).toHaveBeenCalledTimes(1)
    })

    it('disables prev button when on the first file', () => {
        render(
            <SingleFileNavHeader
                file={mockFile}
                currentIndex={0}
                totalFiles={5}
                onPrevFile={vi.fn()}
                onNextFile={vi.fn()}
            />,
        )

        const prevBtn = screen.getByTestId('single-file-prev-button')
        const nextBtn = screen.getByTestId('single-file-next-button')

        expect(prevBtn).toBeDisabled()
        expect(nextBtn).not.toBeDisabled()
    })

    it('disables next button when on the last file', () => {
        render(
            <SingleFileNavHeader
                file={mockFile}
                currentIndex={4}
                totalFiles={5}
                onPrevFile={vi.fn()}
                onNextFile={vi.fn()}
            />,
        )

        const prevBtn = screen.getByTestId('single-file-prev-button')
        const nextBtn = screen.getByTestId('single-file-next-button')

        expect(prevBtn).not.toBeDisabled()
        expect(nextBtn).toBeDisabled()
    })

    it('renders large diff badge when isLargeDiff is true', () => {
        render(
            <SingleFileNavHeader
                file={mockFile}
                currentIndex={0}
                totalFiles={10}
                isLargeDiff={true}
                onPrevFile={vi.fn()}
                onNextFile={vi.fn()}
            />,
        )

        expect(screen.getByTestId('large-diff-badge')).toBeInTheDocument()
        expect(
            screen.getByText('Large diff detected, displaying one file at a time'),
        ).toBeInTheDocument()
    })

    it('renders toggle view mode button when onToggleViewMode is provided', () => {
        const onToggle = vi.fn()
        render(
            <SingleFileNavHeader
                file={mockFile}
                currentIndex={0}
                totalFiles={5}
                onPrevFile={vi.fn()}
                onNextFile={vi.fn()}
                onToggleViewMode={onToggle}
            />,
        )

        const toggleBtn = screen.getByTestId('toggle-view-mode-all-files')
        expect(toggleBtn).toBeInTheDocument()
        fireEvent.click(toggleBtn)
        expect(onToggle).toHaveBeenCalledTimes(1)
    })
})
