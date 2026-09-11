import i18n from '@/i18n'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '@/i18n'
import { TitleBarLeftContribution } from './TitleBarContributions'

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
