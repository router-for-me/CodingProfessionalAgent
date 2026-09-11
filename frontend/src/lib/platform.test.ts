import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { isBrowserEnvironment, isMobileBrowser, isWindowsPlatform, useIsMobileBrowser } from './platform'

describe('platform', () => {
  const originalUserAgent = navigator.userAgent
  const originalMaxTouchPoints = navigator.maxTouchPoints
  const originalInnerWidth = window.innerWidth

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
  })

  describe('isWindowsPlatform', () => {
    it('returns true when userAgent contains Windows', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        configurable: true,
      })
      expect(isWindowsPlatform()).toBe(true)
    })

    it('returns true when userAgent contains Windows Electron', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/34.2.0 Safari/537.36',
        configurable: true,
      })
      expect(isWindowsPlatform()).toBe(true)
    })

    it('returns false for macOS userAgent without Windows indicators', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        configurable: true,
      })
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      })
      expect(isWindowsPlatform()).toBe(false)
    })
  })

  describe('isBrowserEnvironment', () => {
    it('returns true when userAgent does not contain Electron', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        configurable: true,
      })
      expect(isBrowserEnvironment()).toBe(true)
    })

    it('returns false when userAgent contains Electron', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Electron/34.2.0 Safari/537.36',
        configurable: true,
      })
      expect(isBrowserEnvironment()).toBe(false)
    })
  })

  describe('isMobileBrowser', () => {
    it('returns true for iPhone Safari userAgent', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        configurable: true,
      })
      expect(isMobileBrowser()).toBe(true)
    })

    it('returns true for Android Chrome userAgent', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
        configurable: true,
      })
      expect(isMobileBrowser()).toBe(true)
    })

    it('returns true for iPad userAgent', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
        configurable: true,
      })
      expect(isMobileBrowser()).toBe(true)
    })

    it('returns true for touch devices with small screen width in browser', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (CustomBrowser/1.0)',
        configurable: true,
      })
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      })
      Object.defineProperty(window, 'innerWidth', {
        value: 390,
        configurable: true,
      })
      expect(isMobileBrowser()).toBe(true)
    })

    it('returns false for desktop browser with large screen', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        configurable: true,
      })
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      })
      Object.defineProperty(window, 'innerWidth', {
        value: 1280,
        configurable: true,
      })
      expect(isMobileBrowser()).toBe(false)
    })

    it('returns false for Electron runtime even if userAgent matches mobile tokens', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/537.36 Electron/34.2.0',
        configurable: true,
      })
      expect(isMobileBrowser()).toBe(false)
    })
  })

  describe('useIsMobileBrowser', () => {
    it('reacts to window resize events', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (DesktopBrowser/1.0)',
        configurable: true,
      })
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      })
      Object.defineProperty(window, 'innerWidth', {
        value: 1024,
        configurable: true,
      })

      const { result } = renderHook(() => useIsMobileBrowser())
      expect(result.current).toBe(false)

      act(() => {
        Object.defineProperty(window, 'innerWidth', {
          value: 375,
          configurable: true,
        })
        window.dispatchEvent(new Event('resize'))
      })

      expect(result.current).toBe(true)
    })
  })
})

