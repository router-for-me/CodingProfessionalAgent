import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { TurnHeader } from './TurnHeader.js'

describe('TurnHeader', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })
  it('renders completed duration when done', () => {
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={11000}
        streaming={false}
        status="done"
      />,
    )

    expect(screen.getByText('Completed 10s')).toBeInTheDocument()
  })

  it('renders interrupted duration when interrupted or aborted', () => {
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={11000}
        streaming={false}
        status="aborted"
        onToggle={() => {}}
      />,
    )

    expect(screen.getByText('Execution interrupted, ran for 10s')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Execution interrupted, ran for 10s' })).toBeInTheDocument()
  })

  it('renders interrupted duration when interrupted prop is explicitly true', () => {
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={11000}
        streaming={false}
        interrupted
      />,
    )

    expect(screen.getByText('Execution interrupted, ran for 10s')).toBeInTheDocument()
  })

  it('renders interrupted duration when not streaming but status is streaming (killed in flight)', () => {
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={11000}
        streaming={false}
        status="streaming"
      />,
    )

    expect(screen.getByText('Execution interrupted, ran for 10s')).toBeInTheDocument()
  })

  it('toggles expansion when clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    render(
      <TurnHeader
        startedAt={1000}
        completedAt={11000}
        streaming={false}
        interrupted
        onToggle={onToggle}
      />,
    )

    const button = screen.getByRole('button', { name: 'Execution interrupted, ran for 10s' })
    await user.click(button)

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('subtracts pausedMs from elapsed time when paused interval is provided', () => {
    // Total calendar duration = 81_000 - 1_000 = 80s, paused interval = 70s -> net duration = 10s
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={81000}
        streaming={false}
        status="done"
        pausedMs={70000}
      />,
    )

    expect(screen.getByText('Completed 10s')).toBeInTheDocument()
  })

  it('subtracts pausedMs from interrupted label when paused interval is provided', () => {
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={81000}
        streaming={false}
        interrupted
        pausedMs={70000}
      />,
    )

    expect(screen.getByText('Execution interrupted, ran for 10s')).toBeInTheDocument()
  })

  it('renders duration with hours, minutes, and seconds always precise to seconds', () => {
    // 1 hour 21 minutes 23 seconds
    const durationMs = (1 * 3600 + 21 * 60 + 23) * 1000
    render(
      <TurnHeader
        startedAt={0}
        completedAt={durationMs}
        streaming={false}
        interrupted
        onToggle={() => {}}
      />,
    )

    expect(screen.getByText('Execution interrupted, ran for 1h 21m 23s')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Execution interrupted, ran for 1h 21m 23s' }),
    ).toBeInTheDocument()
  })

  it('renders multi-year multi-day duration always precise to seconds', () => {
    // 12 years 2 months 21 days 1 hour 21 minutes 23 seconds
    const longDurationSec = ((12 * 365 + 2 * 30 + 21) * 24 + 1) * 3600 + 21 * 60 + 23
    render(
      <TurnHeader
        startedAt={0}
        completedAt={longDurationSec * 1000}
        streaming={false}
        interrupted
      />,
    )

    expect(
      screen.getByText('Execution interrupted, ran for 12y 2mo 21d 1h 21m 23s'),
    ).toBeInTheDocument()
  })

  it('renders bare completed label when completedAt is missing and never shows 0s', () => {
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={undefined}
        streaming={false}
        status="done"
      />,
    )

    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText('Completed 0s')).toBeNull()
  })

  it('renders bare interrupted label when completedAt is missing and never shows 0s', () => {
    render(
      <TurnHeader
        startedAt={1000}
        completedAt={undefined}
        streaming={false}
        status="aborted"
      />,
    )

    expect(screen.getByText('Execution interrupted')).toBeInTheDocument()
    expect(screen.queryByText(/0s/)).toBeNull()
  })
})
