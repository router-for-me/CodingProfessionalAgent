import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { ThinkingBlock } from './ThinkingBlock.js'

describe('ThinkingBlock', () => {
  it('is expanded by default while streaming and collapses when done without user toggle', () => {
    const { rerender } = render(
      <ThinkingBlock thinking="step one" streaming />,
    )

    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('step one')).toBeVisible()

    rerender(<ThinkingBlock thinking="step one" streaming={false} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the user toggle choice across streaming re-renders', () => {
    const { rerender } = render(
      <ThinkingBlock thinking="alpha" streaming />,
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')

    rerender(<ThinkingBlock thinking="alpha beta" streaming />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('alpha beta')).toBeNull()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')

    rerender(<ThinkingBlock thinking="alpha beta done" streaming={false} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('renders markdown content with existing text styles when expanded', () => {
    render(
      <ThinkingBlock
        thinking={'## Plan\n\n- item **one**'}
        streaming={false}
        defaultOpen
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Plan' })).toBeInTheDocument()
    expect(screen.getByText('one')).toBeInTheDocument()
  })

  it('supports keyboard activation on the toggle button', () => {
    render(<ThinkingBlock thinking="keyboard" streaming={false} />)

    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.keyDown(toggle, { key: 'Enter' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(toggle, { key: ' ' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not reserve a large empty region when thinking text is empty', () => {
    const { container } = render(
      <ThinkingBlock thinking="" streaming />,
    )

    expect(container.firstChild).toBeNull()
  })

  it('shows streaming deltas without collapsing mid-stream by default', () => {
    const { rerender } = render(
      <ThinkingBlock thinking="a" streaming />,
    )
    expect(screen.getByText('a')).toBeVisible()

    rerender(<ThinkingBlock thinking="ab" streaming />)
    expect(screen.getByText('ab')).toBeVisible()
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })
})
