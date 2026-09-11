import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TitlebarChrome } from './TitlebarChrome'

describe('TitlebarChrome', () => {
  const originalUserAgent = navigator.userAgent

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    })
  })

  it('renders without traffic light spacer in browser mode', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
      configurable: true,
    })

    const { container } = render(
      <TitlebarChrome>
        <span data-testid="test-child">Child</span>
      </TitlebarChrome>,
    )

    expect(screen.getByTestId('test-child')).toBeInTheDocument()
    // In browser mode, TitlebarChrome uses flex layout and has no empty traffic-lights spacer
    const rootDiv = container.firstChild as HTMLElement
    expect(rootDiv.className).toContain('flex')
    expect(rootDiv.style.gridTemplateColumns).toBe('')
  })

  it('renders traffic light spacer in Electron desktop mode', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 Electron/34.2.0 Chrome/120.0.0.0 Safari/537.36',
      configurable: true,
    })

    const { container } = render(
      <TitlebarChrome>
        <span data-testid="test-child">Child</span>
      </TitlebarChrome>,
    )

    expect(screen.getByTestId('test-child')).toBeInTheDocument()
    const rootDiv = container.firstChild as HTMLElement
    expect(rootDiv.className).toContain('grid')
    expect(rootDiv.style.gridTemplateColumns).toBe('var(--traffic-lights-pad) auto minmax(0, 1fr)')
  })

  it('renders without traffic light spacer in Windows Electron desktop mode', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/34.2.0 Safari/537.36',
      configurable: true,
    })

    const { container } = render(
      <TitlebarChrome>
        <span data-testid="test-child">Child</span>
      </TitlebarChrome>,
    )

    expect(screen.getByTestId('test-child')).toBeInTheDocument()
    const rootDiv = container.firstChild as HTMLElement
    expect(rootDiv.className).toContain('flex')
    expect(rootDiv.style.gridTemplateColumns).toBe('')
  })
})
