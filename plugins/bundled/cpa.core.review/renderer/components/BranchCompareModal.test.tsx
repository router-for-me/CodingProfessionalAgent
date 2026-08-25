import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { BranchCompareModal } from './BranchCompareModal.js'

describe('BranchCompareModal', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('does not render when isOpen is false', () => {
    render(
      <BranchCompareModal
        isOpen={false}
        onClose={vi.fn()}
        currentBranch="dev"
        defaultBranch="main"
        branches={['dev', 'main']}
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        onApply={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('branch-compare-modal')).not.toBeInTheDocument()
  })

  it('renders and allows switching between Working Tree and Branch mode', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()

    render(
      <BranchCompareModal
        isOpen={true}
        onClose={onClose}
        currentBranch="dev"
        defaultBranch="main"
        branches={['dev', 'main', 'feature/test']}
        baseBranch="main"
        compareTarget="dev"
        compareMode="branch"
        onApply={onApply}
      />,
    )

    expect(screen.getByTestId('branch-compare-modal')).toBeInTheDocument()
    expect(screen.getByText('Working Tree')).toBeInTheDocument()
    expect(screen.getByText('Branch')).toBeInTheDocument()

    // Switch to working tree mode
    fireEvent.click(screen.getByText('Working Tree'))
    expect(screen.getByText('HEAD (dev)')).toBeInTheDocument()

    // Click Apply
    fireEvent.click(screen.getByText('Apply'))
    expect(onApply).toHaveBeenCalledWith({
      baseBranch: 'main',
      compareTarget: 'dev',
      compareMode: 'workingTree',
    })
    expect(onClose).toHaveBeenCalled()
  })
})
