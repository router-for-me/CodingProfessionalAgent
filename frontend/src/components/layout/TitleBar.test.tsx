import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar'

const mockSetSearchOpen = vi.fn()

vi.mock('@/stores/uiStore', () => ({
  useUiStore: Object.assign(
    (selector: (state: any) => any) =>
      selector({
        setSearchOpen: mockSetSearchOpen,
      }),
    {
      getState: () => ({
        setSearchOpen: mockSetSearchOpen,
      }),
    },
  ),
}))

describe('TitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders CPA brand segments with expandable full names', () => {
    render(<TitleBar />)

    expect(screen.getByText('C')).toBeInTheDocument()
    expect(screen.getByText('P')).toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('oding')).toBeInTheDocument()
    expect(screen.getByText('rofessional')).toBeInTheDocument()
    expect(screen.getByText('gent')).toBeInTheDocument()
  })

  it('has accessible title and action buttons', () => {
    render(<TitleBar />)

    expect(screen.getByLabelText('Coding Professional Agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
  })

  it('triggers setSearchOpen(true) when search button is clicked', () => {
    render(<TitleBar />)
    const searchButton = screen.getByRole('button', { name: /search/i })
    fireEvent.click(searchButton)
    expect(mockSetSearchOpen).toHaveBeenCalledWith(true)
  })

  it('opens Easter egg splash overlay when clicking C -> P -> A in sequence', () => {
    render(<TitleBar />)

    expect(screen.queryByTestId('easter-egg-splash-overlay')).toBeNull()

    const segmentC = screen.getByText('C').closest('button')!
    const segmentP = screen.getByText('P').closest('button')!
    const segmentA = screen.getByText('A').closest('button')!

    fireEvent.click(segmentC)
    expect(screen.queryByTestId('easter-egg-splash-overlay')).toBeNull()

    fireEvent.click(segmentP)
    expect(screen.queryByTestId('easter-egg-splash-overlay')).toBeNull()

    fireEvent.click(segmentA)
    expect(screen.getByTestId('easter-egg-splash-overlay')).toBeInTheDocument()
  })

  it('does not open Easter egg when clicking out of sequence', () => {
    render(<TitleBar />)

    const segmentC = screen.getByText('C').closest('button')!
    const segmentP = screen.getByText('P').closest('button')!
    const segmentA = screen.getByText('A').closest('button')!

    fireEvent.click(segmentA)
    expect(screen.queryByTestId('easter-egg-splash-overlay')).toBeNull()

    fireEvent.click(segmentP)
    expect(screen.queryByTestId('easter-egg-splash-overlay')).toBeNull()

    fireEvent.click(segmentC)
    fireEvent.click(segmentA)
    expect(screen.queryByTestId('easter-egg-splash-overlay')).toBeNull()
  })
})
