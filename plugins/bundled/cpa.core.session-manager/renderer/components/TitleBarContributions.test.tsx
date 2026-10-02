import i18n from '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { useUiStore } from '@/stores/uiStore'
import { createHostServices } from '@/application/services/createHostServices'
import { TitleBarLeftContribution, TitleBarRightContribution } from './TitleBarContributions'

describe('TitleBarLeftContribution', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  const originalUserAgent = navigator.userAgent

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    })
  })

  it('renders nothing if left sidebar is not collapsed', () => {
    const { container } = render(
      <TitleBarLeftContribution leftSidebarCollapsed={false} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders sidebar toggle without traffic light spacer in browser mode', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
      configurable: true,
    })

    const { container } = render(
      <TitleBarLeftContribution leftSidebarCollapsed={true} />,
    )

    expect(screen.getByRole('button', { name: /sidebar/i })).toBeInTheDocument()
    const trafficSpacer = container.querySelector('div[style*="--traffic-lights-pad"]')
    expect(trafficSpacer).toBeNull()
  })

  it('renders sidebar toggle with traffic light spacer in Electron mode', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 Electron/34.2.0 Chrome/120.0.0.0 Safari/537.36',
      configurable: true,
    })

    const { container } = render(
      <TitleBarLeftContribution leftSidebarCollapsed={true} />,
    )

    expect(screen.getByRole('button', { name: /sidebar/i })).toBeInTheDocument()
    const trafficSpacer = container.querySelector('div[style*="--traffic-lights-pad"]')
    expect(trafficSpacer).toBeInTheDocument()
  })

  it('renders sidebar toggle without traffic light spacer in Windows Electron mode', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/34.2.0 Safari/537.36',
      configurable: true,
    })

    const { container } = render(
      <TitleBarLeftContribution leftSidebarCollapsed={true} />,
    )

    expect(screen.getByRole('button', { name: /sidebar/i })).toBeInTheDocument()
    const trafficSpacer = container.querySelector('div[style*="--traffic-lights-pad"]')
    expect(trafficSpacer).toBeNull()
    const toggleWrapper = screen.getByRole('button', { name: /sidebar/i }).parentElement
    expect(toggleWrapper?.className).toContain('pl-2.5')
  })
})

describe('TitleBarRightContribution', () => {
  beforeEach(async () => {
    createHostServices()
    await i18n.changeLanguage('en')
    useUiStore.setState({ pinnedSummaryVisible: false })
  })

  it('renders nothing when showPinnedSummaryToggle is false', () => {
    const { container } = render(
      <TitleBarRightContribution showPinnedSummaryToggle={false} />,
    )
    expect(screen.queryByTestId('pinned-summary-toggle')).not.toBeInTheDocument()
    expect(container.firstChild).toBeInTheDocument()
  })

  it('renders toggle button with unselected state when pinnedSummaryVisible is false', () => {
    useUiStore.setState({ pinnedSummaryVisible: false })
    render(<TitleBarRightContribution showPinnedSummaryToggle={true} />)

    const toggle = screen.getByTestId('pinned-summary-toggle')
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('title', 'Show pinned summary')
    expect(toggle.className).not.toContain('bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]')
  })

  it('renders toggle button with selected state when pinnedSummaryVisible is true', () => {
    useUiStore.setState({ pinnedSummaryVisible: true })
    render(<TitleBarRightContribution showPinnedSummaryToggle={true} />)

    const toggle = screen.getByTestId('pinned-summary-toggle')
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('title', 'Hide pinned summary')
    expect(toggle.className).toContain('bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]')
  })

  it('toggles pinnedSummaryVisible on click', async () => {
    const user = userEvent.setup()
    useUiStore.setState({ pinnedSummaryVisible: false })
    render(<TitleBarRightContribution showPinnedSummaryToggle={true} />)

    const toggle = screen.getByTestId('pinned-summary-toggle')
    await user.click(toggle)

    expect(useUiStore.getState().pinnedSummaryVisible).toBe(true)
  })
})
