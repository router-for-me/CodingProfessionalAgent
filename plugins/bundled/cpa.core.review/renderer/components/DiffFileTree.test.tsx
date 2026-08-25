import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { GitDiffFile } from '../utils/gitDiff.js'
import { DiffFileTree } from './DiffFileTree.js'

describe('DiffFileTree', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  const sampleFiles: GitDiffFile[] = [
    {
      oldPath: 'internal/runtime/executor/xai_executor_execute.go',
      newPath: 'internal/runtime/executor/xai_executor_execute.go',
      displayPath: 'internal/runtime/executor/xai_executor_execute.go',
      status: 'modified',
      additions: 1,
      deletions: 1,
      isBinary: false,
      hunks: [],
    },
    {
      oldPath: 'internal/runtime/executor/xai_executor_request.go',
      newPath: 'internal/runtime/executor/xai_executor_request.go',
      displayPath: 'internal/runtime/executor/xai_executor_request.go',
      status: 'modified',
      additions: 10,
      deletions: 2,
      isBinary: false,
      hunks: [],
    },
    {
      oldPath: 'docs/README.md',
      newPath: 'docs/README.md',
      displayPath: 'docs/README.md',
      status: 'added',
      additions: 25,
      deletions: 0,
      isBinary: false,
      hunks: [],
    },
  ]

  it('renders tree nodes for files and directory structure', () => {
    render(
      <DiffFileTree
        files={sampleFiles}
        selectedFilePath="internal/runtime/executor/xai_executor_execute.go"
        onSelectFile={vi.fn()}
      />,
    )

    // Check directory compacting & file items
    expect(screen.getByText('internal / runtime / executor')).toBeInTheDocument()
    expect(screen.getByText('xai_executor_execute.go')).toBeInTheDocument()
    expect(screen.getByText('xai_executor_request.go')).toBeInTheDocument()
    expect(screen.getByText('docs')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('3 files changed')).toBeInTheDocument()
  })

  it('filters files based on search input', () => {
    render(
      <DiffFileTree
        files={sampleFiles}
        selectedFilePath={null}
        onSelectFile={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('Filter files...')
    fireEvent.change(input, { target: { value: 'README' } })

    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.queryByText('xai_executor_execute.go')).not.toBeInTheDocument()
  })

  it('calls onSelectFile when file item is clicked', () => {
    const onSelect = vi.fn()
    render(
      <DiffFileTree
        files={sampleFiles}
        selectedFilePath={null}
        onSelectFile={onSelect}
      />,
    )

    fireEvent.click(screen.getByText('xai_executor_execute.go'))
    expect(onSelect).toHaveBeenCalledWith(sampleFiles[0])
  })

  it('resizes tree on dragging panel resize handle', () => {
    const { container } = render(
      <DiffFileTree
        files={sampleFiles}
        selectedFilePath={null}
        onSelectFile={vi.fn()}
        transition
      />,
    )

    const handle = screen.getByRole('separator', { name: 'Resize file list' })
    expect(handle).toBeInTheDocument()

    const aside = container.querySelector('aside')
    expect(aside).toHaveStyle({ width: '240px' })
    expect(aside?.className).toContain('transition-[width]')

    // Simulate getBoundingClientRect on aside
    if (aside) {
      vi.spyOn(aside, 'getBoundingClientRect').mockReturnValue({
        right: 1000,
        left: 760,
        top: 0,
        bottom: 500,
        width: 240,
        height: 500,
        x: 760,
        y: 0,
        toJSON: () => {},
      })
    }

    // Drag handle leftwards to expand tree
    fireEvent.pointerDown(handle, { clientX: 760, pointerId: 1 })
    expect(aside?.className).not.toContain('transition-[width]')

    fireEvent.pointerMove(window, { clientX: 700 })
    fireEvent.pointerUp(window)

    // 1000 - 700 = 300px
    expect(aside).toHaveStyle({ width: '300px' })
    expect(aside?.className).toContain('transition-[width]')
  })
})
