import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isMobileBrowser, syncMobileBrowserDOM } from './platform'

describe('Mobile Web Typography & Icon Sizing', () => {
  const originalUserAgent = navigator.userAgent
  const originalMaxTouchPoints = navigator.maxTouchPoints
  const originalInnerWidth = window.innerWidth

  beforeEach(() => {
    document.documentElement.removeAttribute('data-mobile-browser')
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    })
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: originalMaxTouchPoints,
      configurable: true,
    })
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      configurable: true,
    })
    document.documentElement.removeAttribute('data-mobile-browser')
  })

  it('marks data-mobile-browser="true" on DOM root for mobile phone browser', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      configurable: true,
    })

    const isMobile = syncMobileBrowserDOM()
    expect(isMobile).toBe(true)
    expect(isMobileBrowser()).toBe(true)
    expect(document.documentElement.getAttribute('data-mobile-browser')).toBe('true')
  })

  it('removes data-mobile-browser attribute on desktop PC web browsers', () => {
    document.documentElement.setAttribute('data-mobile-browser', 'true')
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      configurable: true,
    })
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 0,
      configurable: true,
    })
    Object.defineProperty(window, 'innerWidth', {
      value: 1440,
      configurable: true,
    })

    const isMobile = syncMobileBrowserDOM()
    expect(isMobile).toBe(false)
    expect(isMobileBrowser()).toBe(false)
    expect(document.documentElement.getAttribute('data-mobile-browser')).toBeNull()
  })

  it('removes data-mobile-browser attribute in Electron desktop environment even with mobile UA string', () => {
    document.documentElement.setAttribute('data-mobile-browser', 'true')
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/537.36 Electron/34.2.0',
      configurable: true,
    })

    const isMobile = syncMobileBrowserDOM()
    expect(isMobile).toBe(false)
    expect(document.documentElement.getAttribute('data-mobile-browser')).toBeNull()
  })

  it('verifies that app.css defines comprehensive mobile scaling rules under html[data-mobile-browser="true"]', () => {
    const cssPath = path.resolve(__dirname, '../styles/app.css')
    const cssContent = fs.readFileSync(cssPath, 'utf8')

    // Root variables & font-size on mobile
    expect(cssContent).toContain('html[data-mobile-browser="true"]')
    expect(cssContent).toContain('--ui-font-size: 16px !important;')
    expect(cssContent).toContain('--code-font-size: 13.5px !important;')

    // Scaled arbitrary small fonts
    expect(cssContent).toContain('html[data-mobile-browser="true"] .text-\\[10px\\]')
    expect(cssContent).toContain('html[data-mobile-browser="true"] .text-\\[11px\\]')
    expect(cssContent).toContain('html[data-mobile-browser="true"] .text-\\[12px\\]')
    expect(cssContent).toContain('html[data-mobile-browser="true"] .text-\\[13px\\]')
    expect(cssContent).toContain('html[data-mobile-browser="true"] .text-\\[14px\\]')

    // Scaled micro icon sizes
    expect(cssContent).toContain('html[data-mobile-browser="true"] svg.size-3')
    expect(cssContent).toContain('html[data-mobile-browser="true"] svg.size-3\\.5')
    expect(cssContent).toContain('html[data-mobile-browser="true"] svg.size-4')
    expect(cssContent).toContain('html[data-mobile-browser="true"] svg.size-4\\.5')

    // Touch button targets
    expect(cssContent).toContain('html[data-mobile-browser="true"] button.size-6')
    expect(cssContent).toContain('html[data-mobile-browser="true"] button.size-7')
    expect(cssContent).toContain('html[data-mobile-browser="true"] button.size-8')

    // Sidebar overlay elevation & hiding workspace floating overlays
    expect(cssContent).toContain('html[data-mobile-browser="true"] aside[data-mobile="true"][data-state="open"]')
    expect(cssContent).toContain('z-index: 60 !important;')
    expect(cssContent).toContain('html[data-mobile-browser="true"]:has(aside[data-mobile="true"][data-state="open"]) [data-floating-id]')

    // Mobile Action Sheet text selection suppression
    expect(cssContent).toContain('[data-testid="session-action-sheet"]')
    expect(cssContent).toContain('-webkit-user-select: none !important;')
    expect(cssContent).toContain('-webkit-touch-callout: none !important;')
  })
})
