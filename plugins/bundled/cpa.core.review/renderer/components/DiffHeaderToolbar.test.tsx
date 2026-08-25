import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { GitDiffSummary } from '../utils/gitDiff.js'
import { DiffHeaderToolbar } from './DiffHeaderToolbar.js'

describe('DiffHeaderToolbar', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  const mockSummary: GitDiffSummary = {
    files: [],
    totalAdditions: 296,
    totalDeletions: 43,
    totalFilesChanged: 5,
    rawDiff: '',
  }

  it('renders branch compare trigger with stats and compare subtitle', () => {
    const onOpenCompareModal = vi.fn()
    render(
      <DiffHeaderToolbar
        summary={mockSummary}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={vi.fn()}
        onOpenCompareModal={onOpenCompareModal}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={vi.fn()}
        onAiReview={vi.fn()}
      />,
    )

    expect(screen.getByText('Branch')).toBeInTheDocument()
    expect(screen.getByText('+296')).toBeInTheDocument()
    expect(screen.getByText('-43')).toBeInTheDocument()
    expect(screen.getByText('dev → main')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('branch-compare-trigger'))
    expect(onOpenCompareModal).toHaveBeenCalledTimes(1)
  })

  it('renders "no diff" text when additions and deletions are 0', () => {
    const emptySummary: GitDiffSummary = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFilesChanged: 0,
      rawDiff: '',
    }
    render(
      <DiffHeaderToolbar
        summary={emptySummary}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="workingTree"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={vi.fn()}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={vi.fn()}
        onAiReview={vi.fn()}
      />,
    )

    expect(screen.getByText('No diff')).toBeInTheDocument()
  })

  it('triggers create pull request action and provides tooltip title', () => {
    const onCreatePullRequest = vi.fn()
    render(
      <DiffHeaderToolbar
        summary={mockSummary}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={vi.fn()}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={onCreatePullRequest}
        onAiReview={vi.fn()}
      />,
    )

    const prButton = screen.getByTestId('create-pr-button')
    expect(prButton).toHaveAttribute('title', 'Create Pull Request')
    fireEvent.click(prButton)
    expect(onCreatePullRequest).toHaveBeenCalledTimes(1)
  })

  it('triggers toggle split view style action', () => {
    const onToggleSplitView = vi.fn()
    render(
      <DiffHeaderToolbar
        summary={mockSummary}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={onToggleSplitView}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={vi.fn()}
        onAiReview={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('diff-view-style-toggle'))
    expect(onToggleSplitView).toHaveBeenCalledTimes(1)
  })

  it('triggers toggle all expanded action', () => {
    const onToggleAllExpanded = vi.fn()
    render(
      <DiffHeaderToolbar
        summary={mockSummary}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={onToggleAllExpanded}
        onToggleSplitView={vi.fn()}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={vi.fn()}
        onAiReview={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('toggle-all-expanded-button'))
    expect(onToggleAllExpanded).toHaveBeenCalledTimes(1)
  })

  it('triggers copy diff action from more menu', () => {
    const onCopyDiff = vi.fn()
    render(
      <DiffHeaderToolbar
        summary={mockSummary}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={vi.fn()}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={onCopyDiff}
        onCreatePullRequest={vi.fn()}
        onAiReview={vi.fn()}
      />,
    )

    const moreButton = screen.getByTestId('diff-toolbar-more-button')
    fireEvent.click(moreButton)

    const copyDiffBtn = screen.getByTestId('diff-toolbar-copy-diff-button')
    fireEvent.click(copyDiffBtn)
    expect(onCopyDiff).toHaveBeenCalledTimes(1)
  })

  it('triggers AI review action from more menu', () => {
    const onAiReview = vi.fn()
    render(
      <DiffHeaderToolbar
        summary={mockSummary}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={vi.fn()}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={vi.fn()}
        onAiReview={onAiReview}
      />,
    )

    const moreButton = screen.getByTestId('diff-toolbar-more-button')
    fireEvent.click(moreButton)

    const aiReviewBtn = screen.getByTestId('diff-toolbar-ai-review-button')
    fireEvent.click(aiReviewBtn)
    expect(onAiReview).toHaveBeenCalledTimes(1)
  })

  it('triggers toggle single file view mode from toolbar and more menu', () => {
    const onToggleSingleFileMode = vi.fn()
    const summaryWithFiles: GitDiffSummary = {
      files: [
        {
          oldPath: 'a.ts',
          newPath: 'a.ts',
          displayPath: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          isBinary: false,
          hunks: [],
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
      totalFilesChanged: 1,
      rawDiff: '',
    }

    const { rerender } = render(
      <DiffHeaderToolbar
        summary={summaryWithFiles}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isSingleFileMode={false}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={vi.fn()}
        onToggleSingleFileMode={onToggleSingleFileMode}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={vi.fn()}
        onAiReview={vi.fn()}
      />,
    )

    const viewModeToggle = screen.getByTestId('diff-view-mode-toggle')
    expect(viewModeToggle).toBeInTheDocument()
    expect(viewModeToggle).toHaveAttribute('title', 'Single file view')

    fireEvent.click(viewModeToggle)
    expect(onToggleSingleFileMode).toHaveBeenCalledTimes(1)

    // Rerender in single file mode
    rerender(
      <DiffHeaderToolbar
        summary={summaryWithFiles}
        currentBranch="dev"
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        sidebarOpen={true}
        allExpanded={true}
        isSplitView={false}
        isSingleFileMode={true}
        isLoading={false}
        onToggleSidebar={vi.fn()}
        onToggleAllExpanded={vi.fn()}
        onToggleSplitView={vi.fn()}
        onToggleSingleFileMode={onToggleSingleFileMode}
        onOpenCompareModal={vi.fn()}
        onRefresh={vi.fn()}
        onCopyDiff={vi.fn()}
        onCreatePullRequest={vi.fn()}
        onAiReview={vi.fn()}
      />,
    )

    expect(screen.getByTestId('diff-view-mode-toggle')).toHaveAttribute(
      'title',
      'All files view',
    )

    // Toggle from more menu
    const moreButton = screen.getByTestId('diff-toolbar-more-button')
    fireEvent.click(moreButton)

    const menuToggle = screen.getByTestId('diff-toolbar-toggle-view-mode-menu')
    fireEvent.click(menuToggle)
    expect(onToggleSingleFileMode).toHaveBeenCalledTimes(2)
  })
})
