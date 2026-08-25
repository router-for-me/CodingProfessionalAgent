import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EasterEggSplashOverlay } from './EasterEggSplashOverlay'

describe('EasterEggSplashOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('renders nothing when closed', () => {
    render(<EasterEggSplashOverlay open={false} onClose={vi.fn()} />)
    expect(screen.queryByTestId('easter-egg-splash-overlay')).toBeNull()
  })

  it('initially renders CLIProxyAPI and progresses through animation phases', () => {
    render(<EasterEggSplashOverlay open={true} onClose={vi.fn()} />)

    expect(screen.getByTestId('easter-egg-splash-overlay')).toBeInTheDocument()

    // Initially displays CLIProxyAPI components
    expect(screen.getByTestId('cpa-segment-C')).toBeInTheDocument()
    expect(screen.getByTestId('cpa-segment-P')).toBeInTheDocument()
    expect(screen.getByTestId('cpa-segment-A')).toBeInTheDocument()
    expect(screen.getByTestId('char-L-1')).toBeInTheDocument()
    expect(screen.getByTestId('char-I-2')).toBeInTheDocument()

    // Advance timers through dropping, merging, and typing phases
    act(() => {
      vi.advanceTimersByTime(12000)
    })

    // Now typed suffixes are visible
    expect(screen.getByText('oding')).toBeInTheDocument()
    expect(screen.getByText('rofessional')).toBeInTheDocument()
    expect(screen.getByText('gent')).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked after transition', () => {
    const handleClose = vi.fn()
    render(<EasterEggSplashOverlay open={true} onClose={handleClose} />)

    const closeBtn = screen.getByRole('button', { name: /close splash/i })
    fireEvent.click(closeBtn)

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape key is pressed', () => {
    const handleClose = vi.fn()
    render(<EasterEggSplashOverlay open={true} onClose={handleClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when background overlay is clicked', () => {
    const handleClose = vi.fn()
    render(<EasterEggSplashOverlay open={true} onClose={handleClose} />)

    const overlay = screen.getByTestId('easter-egg-splash-overlay')
    fireEvent.click(overlay)

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(handleClose).toHaveBeenCalledTimes(1)
  })
})
